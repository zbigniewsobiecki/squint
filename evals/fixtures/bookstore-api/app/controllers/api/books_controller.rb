module Api
  class BooksController < BaseController
    skip_before_action :authenticate!, only: [:index, :show]
    before_action :set_book, only: [:show, :update, :destroy, :restock]
    before_action :require_admin!, only: [:create, :update, :destroy, :restock]

    def index
      books = paginate(Book.includes(:author).in_stock)
      render_success(books.map { |b| BookSerializer.new(b).as_json })
    end

    def show
      render_success(BookSerializer.new(@book).as_json)
    end

    def create
      book = Book.new(book_params)
      if book.save
        render_success(BookSerializer.new(book).as_json, status: :created)
      else
        render_error(book.errors.full_messages.join(', '))
      end
    end

    def update
      if @book.update(book_params)
        render_success(BookSerializer.new(@book).as_json)
      else
        render_error(@book.errors.full_messages.join(', '))
      end
    end

    def destroy
      @book.destroy!
      head :no_content
    end

    def restock
      quantity = params[:quantity].to_i
      @book.update!(stock_count: @book.stock_count + quantity)
      render_success(BookSerializer.new(@book).as_json)
    end

    private

    def set_book
      @book = Book.find_by(id: params[:id])
      render_not_found('Book') unless @book
    end

    def book_params
      params.require(:book).permit(:title, :isbn, :price_cents, :stock_count, :author_id, :published)
    end

    def require_admin!
      render_error('Forbidden', status: :forbidden) unless current_user&.admin?
    end
  end
end
